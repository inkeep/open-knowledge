import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  buildHistory,
  CONSECUTIVE_NON_PASS_THRESHOLD,
  classifyHistoryFailure,
  evaluateAlarm,
  STALE_FAST_TIER_WINDOW_DAYS,
} from './evaluate-smoke-alarm.mjs';

const NOW = Date.parse('2026-07-28T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const cut = (over = {}) => ({
  at: daysAgo(1),
  qualified: true,
  verdict: 'non-pass',
  promoted: false,
  ...over,
});
const passing = (over = {}) => cut({ verdict: 'pass', promoted: true, ...over });
const notQualified = (over = {}) =>
  cut({ qualified: false, verdict: null, promoted: false, ...over });

const run = (history) => evaluateAlarm({ history, nowMs: NOW });

describe('condition 1 — consecutive non-pass verdicts', () => {
  test('fires at exactly the threshold', () => {
    const r = run([cut({ at: daysAgo(1) }), cut({ at: daysAgo(2) }), cut({ at: daysAgo(3) })]);
    expect(r.alarm).toBe(true);
    expect(r.reasons.join(' ')).toContain('3 consecutive fast-tier candidates');
    expect(CONSECUTIVE_NON_PASS_THRESHOLD).toBe(3);
  });

  test('stays silent at exactly one below the threshold', () => {
    const r = run([cut({ at: daysAgo(1) }), cut({ at: daysAgo(2) }), passing({ at: daysAgo(3) })]);
    expect(r.alarm).toBe(false);
  });

  test('counts only the LEADING run, so an old bad patch does not fire forever', () => {
    const r = run([
      passing({ at: daysAgo(1) }),
      cut({ at: daysAgo(2) }),
      cut({ at: daysAgo(3) }),
      cut({ at: daysAgo(4) }),
    ]);
    expect(r.alarm).toBe(false);
  });

  test('non-qualifying cuts do not break the streak', () => {
    const r = run([
      cut({ at: daysAgo(1) }),
      notQualified({ at: daysAgo(2) }),
      cut({ at: daysAgo(3) }),
      notQualified({ at: daysAgo(4) }),
      cut({ at: daysAgo(5) }),
    ]);
    expect(r.alarm).toBe(true);
    expect(r.reasons.join(' ')).toContain('3 consecutive');
  });
});

describe('condition 2 — armed but never promoting', () => {
  test('fires when a qualifying cut sits inside the window with no promotion', () => {
    const r = run([cut({ at: daysAgo(3) })]);
    expect(r.alarm).toBe(true);
    expect(r.reasons.join(' ')).toContain('armed and reaching nothing');
  });

  test('stays silent when a promotion happened inside the window', () => {
    const r = run([cut({ at: daysAgo(3) }), passing({ at: daysAgo(5) })]);
    expect(r.alarm).toBe(false);
  });

  test('a qualifying cut just inside the window fires; just outside does not', () => {
    expect(STALE_FAST_TIER_WINDOW_DAYS).toBe(14);
    const inside = run([cut({ at: daysAgo(13.9) })]);
    expect(inside.alarm).toBe(true);
    const outside = run([cut({ at: daysAgo(14.1) })]);
    expect(outside.alarm).toBe(false);
  });

  test('a promotion that has aged out of the window no longer counts as healthy', () => {
    const r = run([cut({ at: daysAgo(2) }), passing({ at: daysAgo(20) })]);
    expect(r.alarm).toBe(true);
    expect(r.reasons.join(' ')).toContain('armed and reaching nothing');
  });
});

describe('a disarmed fast tier is not a broken one', () => {
  test('no cut qualified in the window: silent', () => {
    const r = run([notQualified({ at: daysAgo(1) }), notQualified({ at: daysAgo(5) })]);
    expect(r.alarm).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test('empty history — the shipped default — is silent', () => {
    expect(run([])).toEqual({ alarm: false, reasons: [] });
  });

  test('a long stretch of non-qualifying cuts never fires', () => {
    const r = run(Array.from({ length: 40 }, (_, i) => notQualified({ at: daysAgo(i * 0.3) })));
    expect(r.alarm).toBe(false);
  });

  test('qualified-but-never-promoted stays silent when the switch is off', () => {
    const history = [cut({ at: daysAgo(1) }), cut({ at: daysAgo(4) })];
    expect(evaluateAlarm({ history, nowMs: NOW, armed: false })).toEqual({
      alarm: false,
      reasons: [],
    });
    expect(evaluateAlarm({ history, nowMs: NOW, armed: true }).alarm).toBe(true);
  });

  test('a persistently broken gate is also not a finding while disarmed', () => {
    const history = Array.from({ length: CONSECUTIVE_NON_PASS_THRESHOLD + 1 }, (_, i) =>
      cut({ at: daysAgo(i + 1) }),
    );
    expect(evaluateAlarm({ history, nowMs: NOW, armed: false }).alarm).toBe(false);
    expect(evaluateAlarm({ history, nowMs: NOW, armed: true }).alarm).toBe(true);
  });
});

describe('both conditions can fire together', () => {
  test('reasons name each independently', () => {
    const r = run([cut({ at: daysAgo(1) }), cut({ at: daysAgo(2) }), cut({ at: daysAgo(3) })]);
    expect(r.reasons).toHaveLength(2);
    expect(r.reasons[0]).not.toBe(r.reasons[1]);
  });
});

describe('buildHistory', () => {
  const runs = [{ databaseId: 1, createdAt: daysAgo(1) }];

  test('a run whose smoke job never existed did not qualify', () => {
    expect(buildHistory({ runs, jobsForRun: () => [] })[0]).toMatchObject({
      qualified: false,
      promoted: false,
    });
  });

  test('a skipped smoke job did not qualify — that is the inert default', () => {
    const jobs = [
      { name: "Smoke the fast-tier candidate's DMG", conclusion: 'skipped', steps: [] },
    ];
    expect(buildHistory({ runs, jobsForRun: () => jobs })[0].qualified).toBe(false);
  });

  test('a cancelled smoke job is a superseded tick, not an unanswered gate', () => {
    const jobs = [
      { name: "Smoke the fast-tier candidate's DMG", conclusion: 'cancelled', steps: [] },
    ];
    expect(buildHistory({ runs, jobsForRun: () => jobs })[0]).toMatchObject({
      qualified: false,
      verdict: null,
      promoted: false,
    });
  });

  test('a smoke job whose dispatch step succeeded is a pass', () => {
    const jobs = [
      {
        name: "Smoke the fast-tier candidate's DMG",
        conclusion: 'success',
        steps: [
          { name: 'Dispatch promote-stable for the smoke-proven candidate', conclusion: 'success' },
        ],
      },
    ];
    expect(buildHistory({ runs, jobsForRun: () => jobs })[0]).toMatchObject({
      qualified: true,
      verdict: 'pass',
      promoted: true,
    });
  });

  test('a smoke job whose dispatch step was skipped is a non-pass', () => {
    const jobs = [
      {
        name: "Smoke the fast-tier candidate's DMG",
        conclusion: 'success',
        steps: [
          { name: 'Dispatch promote-stable for the smoke-proven candidate', conclusion: 'skipped' },
        ],
      },
    ];
    expect(buildHistory({ runs, jobsForRun: () => jobs })[0]).toMatchObject({
      qualified: true,
      verdict: 'non-pass',
      promoted: false,
    });
  });

  test('the job and step names it keys on exist verbatim in the workflow', () => {
    const wf = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'workflows',
        'select-beta-to-promote.yml',
      ),
      'utf8',
    );
    expect(wf).toContain("Smoke the fast-tier candidate's DMG");
    expect(wf).toContain('Dispatch promote-stable for the smoke-proven candidate');
  });

  test('the alarm pages Slack and never Discord', () => {
    const wf = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'workflows',
        'select-beta-to-promote.yml',
      ),
      'utf8',
    );
    const pageStart = wf.indexOf('- name: Page the release channel');
    expect(pageStart, 'no "Page the release channel" step').toBeGreaterThan(-1);
    const step = wf.slice(pageStart);
    expect(step).toContain('SLACK_WEBHOOK_URL');
    expect(step).not.toContain('DISCORD_WEBHOOK_URL');
    expect(step).not.toMatch(/^\s*post\s+.*Discord\s*$/m);
  });
});

describe('classifyHistoryFailure', () => {
  test.each([
    'request timed out',
    'API rate limit exceeded',
    'connect ECONNREFUSED 140.82.121.6:443',
    'read ECONNRESET',
    'getaddrinfo EAI_AGAIN api.github.com',
    'socket hang up',
    'HTTP 502 Bad Gateway',
    'HTTP 503 Service Unavailable',
  ])('recoverable: %s → notice', (msg) => {
    expect(classifyHistoryFailure(msg)).toBe('::notice::');
  });

  test.each([
    'gh: command not found',
    'authentication failed: token expired',
    'HTTP 401: Bad credentials',
    'could not determine GITHUB_REPOSITORY',
    'HTTP 404: Not Found',
  ])('permanent: %s → warning', (msg) => {
    expect(classifyHistoryFailure(msg)).toBe('::warning::');
  });

  test('an absent message is treated as permanent, not quietly ignored', () => {
    expect(classifyHistoryFailure(undefined)).toBe('::warning::');
    expect(classifyHistoryFailure('')).toBe('::warning::');
  });
});

describe('buildHistory run-id fallback', () => {
  test('falls back to run.id when databaseId is absent', () => {
    const seen = [];
    buildHistory({
      runs: [{ id: 42, createdAt: daysAgo(1) }],
      jobsForRun: (id) => {
        seen.push(id);
        return [];
      },
    });
    expect(seen).toEqual([42]);
  });

  test('prefers databaseId when both are present', () => {
    const seen = [];
    buildHistory({
      runs: [{ databaseId: 7, id: 42, createdAt: daysAgo(1) }],
      jobsForRun: (id) => {
        seen.push(id);
        return [];
      },
    });
    expect(seen).toEqual([7]);
  });

  test('a jobsForRun returning null does not throw', () => {
    expect(
      buildHistory({ runs: [{ databaseId: 1, createdAt: daysAgo(1) }], jobsForRun: () => null })[0]
        .qualified,
    ).toBe(false);
  });
});
