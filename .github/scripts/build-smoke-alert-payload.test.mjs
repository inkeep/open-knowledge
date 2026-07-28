import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  ALERT_COLOR_DECIMAL,
  buildDiscordPayload,
  buildPayload,
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
    const discord = JSON.stringify(buildDiscordPayload(base));
    for (const needle of ['v1.2.3', 'fail', base.runUrl, 'event_type=desktop-release']) {
      expect(discord).toContain(needle);
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
  test('does not reuse the celebratory headline or the announcement colour', () => {
    const slack = JSON.stringify(buildSlackPayload(base));
    const discord = buildDiscordPayload(base);
    expect(slack).not.toContain('🎉');
    expect(slack).not.toContain('released');
    expect(slack).toContain('🚨');
    expect(slack).toContain('RELEASE BLOCKED');
    // 3638527 is the blue the routine announcement uses in desktop-release.yml.
    expect(desktopRelease).toContain('color: 3638527');
    expect(discord.embeds[0].color).toBe(ALERT_COLOR_DECIMAL);
    expect(discord.embeds[0].color).not.toBe(3638527);
  });

  test('the Discord alert suppresses mentions like the announcement does', () => {
    expect(buildDiscordPayload(base).allowed_mentions).toEqual({ parse: [] });
  });

  test('bold markup is Discord-flavoured in the Discord payload', () => {
    const discord = buildDiscordPayload(base);
    expect(discord.embeds[0].description).toContain('**Tag:**');
    expect(discord.embeds[0].description).not.toMatch(/(^|[^*])\*Tag:\*/);
    // Slack keeps its own single-asterisk mrkdwn.
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
    expect(JSON.stringify(buildDiscordPayload(nasty))).toContain('line one\\nline');
  });
});

describe('parseArgs', () => {
  const argv = (...rest) => ['node', 'x', ...rest];

  test('reads every flag the workflow step passes', () => {
    const parsed = parseArgs(
      argv(
        '--channel',
        'discord',
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
      channel: 'discord',
      tag: 'v1.2.3',
      verdict: 'error',
      reason: 'mount failed',
      runUrl: 'https://example.test/run',
      repo: 'inkeep/open-knowledge',
    });
  });

  test('rejects a missing or unknown channel rather than emitting a half-built payload', () => {
    expect(() => parseArgs(argv('--tag', 'v1'))).toThrow(/--channel/);
    expect(() => parseArgs(argv('--channel', 'email', '--tag', 'v1'))).toThrow(/--channel/);
  });

  test('rejects a missing tag', () => {
    expect(() => parseArgs(argv('--channel', 'slack'))).toThrow(/--tag/);
  });

  test('defaults an absent verdict to error rather than silently claiming a pass', () => {
    expect(parseArgs(argv('--channel', 'slack', '--tag', 'v1')).verdict).toBe('error');
  });

  test('buildPayload dispatches on channel', () => {
    expect(buildPayload({ ...base, channel: 'slack' }).blocks).toBeDefined();
    expect(buildPayload({ ...base, channel: 'discord' }).embeds).toBeDefined();
  });
});

describe('workflow wiring', () => {
  test('the alert step is failure-conditioned, not success-conditioned', () => {
    const step = desktopRelease.slice(desktopRelease.indexOf('- name: Alert on a blocked release'));
    expect(step.slice(0, 400)).toContain('if: failure()');
    expect(step.slice(0, 400)).not.toContain('if: success()');
  });

  test('the alert reads its builder from the workflow commit, not the release tag', () => {
    // On repository_dispatch the workflow runs from the default branch while
    // the job checks out client_payload.ref — a tag that can predate this
    // script. v0.41.0 lost its Slack announcement to exactly that.
    const step = desktopRelease.slice(desktopRelease.indexOf('- name: Alert on a blocked release'));
    expect(step).toContain('git fetch --depth=1 origin "$GITHUB_SHA"');
    expect(step).toContain(
      'git show "${GITHUB_SHA}:.github/scripts/build-smoke-alert-payload.mjs"',
    );
  });

  test('the alert reuses the existing webhook secrets and introduces none', () => {
    const step = desktopRelease
      .slice(desktopRelease.indexOf('- name: Alert on a blocked release'))
      .slice(0, 4000);
    expect(step).toContain('secrets.SLACK_WEBHOOK_URL');
    expect(step).toContain('secrets.DISCORD_WEBHOOK_URL');
    const secretNames = new Set(
      [...desktopRelease.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]),
    );
    expect(secretNames.has('SLACK_WEBHOOK_URL')).toBe(true);
    expect(secretNames.has('DISCORD_WEBHOOK_URL')).toBe(true);
  });

  test('an unset webhook is a notice-level skip, and a failed POST is a warning', () => {
    const step = desktopRelease
      .slice(desktopRelease.indexOf('- name: Alert on a blocked release'))
      .slice(0, 5000);
    // Unset secret: annotate and return 0 — never fail the step.
    expect(step).toContain('::notice::${label} webhook not set');
    expect(step).toMatch(/if \[\[ -z "\$webhook" \]\]; then[\s\S]{0,200}?return 0/);
    // A dead webhook warns; it must not mask the smoke failure that caused it.
    expect(step).toContain('::warning::${label} smoke alert failed to POST');
    // Both channels are actually driven.
    expect(step).toContain('post slack "${SLACK_WEBHOOK_URL:-}"');
    expect(step).toContain('post discord "${DISCORD_WEBHOOK_URL:-}"');
  });

  test('the annotation is emitted in addition to the page, not instead of it', () => {
    const step = desktopRelease
      .slice(desktopRelease.indexOf('- name: Alert on a blocked release'))
      .slice(0, 5000);
    const slackAt = step.indexOf('post slack');
    const annotationAt = step.indexOf('::error::RELEASE BLOCKED');
    expect(slackAt).toBeGreaterThan(-1);
    expect(annotationAt).toBeGreaterThan(slackAt);
  });
});
