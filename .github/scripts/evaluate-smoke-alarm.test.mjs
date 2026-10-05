import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  alarmObservation,
  buildHistory,
  CONSECUTIVE_NON_PASS_THRESHOLD,
  classifyHistoryFailure,
  completedRunsNewestFirst,
  evaluateAlarm,
  listingIncludesRun,
  RUN_LIST_ARGS,
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

describe('incident reporter observations', () => {
  test('an armed failure supplies a stable incident identity', () => {
    expect(
      alarmObservation({ history: [cut({ failureStage: 'Download' })], nowMs: NOW, armed: true }),
    ).toMatchObject({ observed: true, alarm: true, incident: 'Download' });
  });

  test('an observed successful dispatch can announce recovery', () => {
    expect(alarmObservation({ history: [passing()], nowMs: NOW, armed: true })).toMatchObject({
      observed: true,
      alarm: false,
      incident: '',
    });
  });

  test.each([[], [notQualified()], [passing()], [cut()]])(
    'disarming never clears an acknowledgement: %j',
    (...history) => {
      expect(alarmObservation({ history, nowMs: NOW, armed: false }).observed).toBe(false);
    },
  );

  test('no qualifying evidence cannot announce recovery', () => {
    for (const history of [[], [notQualified()]]) {
      expect(alarmObservation({ history, nowMs: NOW, armed: true }).observed).toBe(false);
    }
  });

  test('a below-threshold refusal is not evidence of recovery', () => {
    expect(
      alarmObservation({ history: [cut(), passing()], nowMs: NOW, armed: true }).observed,
    ).toBe(false);
  });
});

describe('condition 1 — consecutive non-pass verdicts', () => {
  test('fires at exactly the threshold', () => {
    const r = run([cut({ at: daysAgo(1) }), cut({ at: daysAgo(2) }), cut({ at: daysAgo(3) })]);
    expect(r.alarm).toBe(true);
    expect(r.reasons.join(' ')).toContain('3 consecutive fast-tier attempts');
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
    expect(r.reasons.join(' ')).toContain('no successful fast-tier dispatch observed');
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
    expect(r.reasons.join(' ')).toContain('no successful fast-tier dispatch observed');
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
    expect(wf).toContain('name: Evaluate 24h soak + business-hours gate');
    expect(wf).toContain('- name: Skip the fast-tier candidate whose DMG already failed the smoke');
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
  test('a successful no-op dispatch step is not a promotion receipt', () => {
    const history = buildHistory({
      runs: [{ id: 42, createdAt: daysAgo(1) }],
      jobsForRun: () => [
        {
          name: "Smoke the fast-tier candidate's DMG",
          status: 'completed',
          conclusion: 'success',
          steps: [
            {
              name: 'Dispatch promote-stable for the smoke-proven candidate',
              conclusion: 'success',
            },
            { name: 'Record a successful fast-tier dispatch', conclusion: 'skipped' },
          ],
        },
      ],
    });
    expect(history[0].promoted).toBe(false);
    expect(run([...history, ...history, ...history]).alarm).toBe(false);
  });

  test('an in-progress smoke is not a failed attempt', () => {
    const history = buildHistory({
      runs: [{ id: 42, createdAt: daysAgo(1) }],
      jobsForRun: () => [
        { name: "Smoke the fast-tier candidate's DMG", status: 'in_progress', conclusion: null },
      ],
    });
    expect(history[0].qualified).toBe(false);
  });

  test('download failure is identified without claiming an executed smoke failure', () => {
    const history = buildHistory({
      runs: [{ id: 42, createdAt: daysAgo(1) }],
      jobsForRun: () => [
        {
          name: "Smoke the fast-tier candidate's DMG",
          status: 'completed',
          conclusion: 'failure',
          steps: [
            { name: "Download the candidate's DMG", conclusion: 'failure' },
            { name: 'Smoke the DMG', conclusion: 'skipped' },
          ],
        },
      ],
    });
    expect(history[0]).toMatchObject({
      qualified: true,
      promoted: false,
      failureStage: "Download the candidate's DMG",
    });
    expect(run([...history, ...history, ...history]).reasons[0]).toContain(
      "Download the candidate's DMG",
    );
  });

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

describe('run history listing', () => {
  test('never asks GitHub to filter by status, which returns an arbitrary old page', () => {
    expect(RUN_LIST_ARGS).not.toContain('--status');
    expect(RUN_LIST_ARGS.join(' ')).toContain('status');
  });

  test('keeps only completed runs, newest first', () => {
    const runs = [
      { databaseId: 1, createdAt: daysAgo(3), status: 'completed' },
      { databaseId: 2, createdAt: daysAgo(0), status: 'in_progress' },
      { databaseId: 3, createdAt: daysAgo(1), status: 'completed' },
      { databaseId: 4, createdAt: daysAgo(2), status: 'queued' },
    ];
    expect(completedRunsNewestFirst(runs).map((r) => r.databaseId)).toEqual([3, 1]);
  });

  test('a listing that does not contain the evaluating run is not current history', () => {
    const runs = [
      { databaseId: 10, createdAt: daysAgo(20), status: 'completed' },
      { databaseId: 11, createdAt: daysAgo(20), status: 'completed' },
    ];
    expect(listingIncludesRun(runs, '99')).toBe(false);
    expect(listingIncludesRun([...runs, { databaseId: 99, status: 'in_progress' }], '99')).toBe(
      true,
    );
  });

  test('outside Actions there is no run id to anchor on, so the listing is accepted', () => {
    expect(listingIncludesRun([], undefined)).toBe(true);
  });
});

describe('a remembered smoke failure stays visible to the alarm', () => {
  const evaluateJob = (conclusion) => ({
    name: 'Evaluate 24h soak + business-hours gate',
    status: 'completed',
    conclusion: 'success',
    steps: [
      {
        name: 'Skip the fast-tier candidate whose DMG already failed the smoke',
        conclusion,
      },
    ],
  });
  const skippedSmoke = {
    name: "Smoke the fast-tier candidate's DMG",
    status: 'completed',
    conclusion: 'skipped',
    steps: [],
  };

  test('a tick that skipped a remembered failure is a qualified non-pass at the smoke stage', () => {
    const [entry] = buildHistory({
      runs: [{ databaseId: 1, createdAt: daysAgo(1) }],
      jobsForRun: () => [evaluateJob('success'), skippedSmoke],
    });
    expect(entry).toEqual({
      at: daysAgo(1),
      qualified: true,
      verdict: 'non-pass',
      promoted: false,
      failureStage: 'Smoke or dispatch',
    });
  });

  test('a tick with no remembered failure and no smoke did not qualify', () => {
    const [entry] = buildHistory({
      runs: [{ databaseId: 1, createdAt: daysAgo(1) }],
      jobsForRun: () => [evaluateJob('skipped'), skippedSmoke],
    });
    expect(entry.qualified).toBe(false);
  });

  test('remembered skips after a successful re-smoke do not reopen the incident', () => {
    const passedSmoke = {
      name: "Smoke the fast-tier candidate's DMG",
      status: 'completed',
      conclusion: 'success',
      steps: [
        { name: 'Dispatch promote-stable for the smoke-proven candidate', conclusion: 'success' },
        { name: 'Record a successful fast-tier dispatch', conclusion: 'success' },
      ],
    };
    const runs = Array.from({ length: 5 }, (_, i) => ({
      databaseId: i + 1,
      createdAt: new Date(NOW - i * 10 * 60 * 1000).toISOString(),
    }));
    const history = buildHistory({
      runs,
      jobsForRun: (id) =>
        id === 5 ? [evaluateJob('skipped'), passedSmoke] : [evaluateJob('success'), skippedSmoke],
    });
    expect(history.filter((h) => h.qualified)).toHaveLength(1);
    expect(alarmObservation({ history, nowMs: NOW, armed: true })).toMatchObject({
      alarm: false,
      incident: '',
    });
  });

  test('remembered skips after a failed smoke still count', () => {
    const failedSmoke = {
      name: "Smoke the fast-tier candidate's DMG",
      status: 'completed',
      conclusion: 'success',
      steps: [
        { name: 'Dispatch promote-stable for the smoke-proven candidate', conclusion: 'skipped' },
        { name: 'Record a successful fast-tier dispatch', conclusion: 'skipped' },
      ],
    };
    const runs = Array.from({ length: 4 }, (_, i) => ({
      databaseId: i + 1,
      createdAt: new Date(NOW - i * 10 * 60 * 1000).toISOString(),
    }));
    const history = buildHistory({
      runs,
      jobsForRun: (id) =>
        id === 4 ? [evaluateJob('skipped'), failedSmoke] : [evaluateJob('success'), skippedSmoke],
    });
    expect(history.filter((h) => h.qualified)).toHaveLength(4);
    expect(alarmObservation({ history, nowMs: NOW, armed: true }).alarm).toBe(true);
  });

  test.each([
    {
      name: 'the newest older smoke failed although an older one passed',
      ticks: ['skip', 'skip', 'skip', 'fail', 'pass'],
      alarm: true,
    },
    {
      name: 'a newer failed smoke of another beta does not decide older skips',
      ticks: ['fail', 'skip', 'skip', 'skip', 'pass'],
      alarm: false,
    },
    {
      name: 'an unqualified tick between the pass and the skips does not reset the rule',
      ticks: ['skip', 'skip', 'skip', 'none', 'pass'],
      alarm: false,
    },
  ])(
    'a remembered skip is decided by the newest smoke older than it: $name',
    ({ ticks, alarm }) => {
      const smokeJob = (dispatched) => ({
        name: "Smoke the fast-tier candidate's DMG",
        status: 'completed',
        conclusion: 'success',
        steps: [
          {
            name: 'Dispatch promote-stable for the smoke-proven candidate',
            conclusion: dispatched ? 'success' : 'skipped',
          },
          {
            name: 'Record a successful fast-tier dispatch',
            conclusion: dispatched ? 'success' : 'skipped',
          },
        ],
      });
      const jobsFor = {
        skip: [evaluateJob('success'), skippedSmoke],
        none: [evaluateJob('skipped'), skippedSmoke],
        pass: [evaluateJob('skipped'), smokeJob(true)],
        fail: [evaluateJob('skipped'), smokeJob(false)],
      };
      const runs = ticks.map((_, i) => ({
        databaseId: i + 1,
        createdAt: new Date(NOW - i * 10 * 60 * 1000).toISOString(),
      }));
      const history = buildHistory({ runs, jobsForRun: (id) => jobsFor[ticks[id - 1]] });
      expect(alarmObservation({ history, nowMs: NOW, armed: true }).alarm).toBe(alarm);
    },
  );

  test('a broken beta keeps alarming after its only smoke attempt has left the sample', () => {
    const runs = Array.from({ length: 60 }, (_, i) => ({
      databaseId: i + 1,
      createdAt: new Date(NOW - i * 10 * 60 * 1000).toISOString(),
    }));
    const history = buildHistory({
      runs,
      jobsForRun: () => [evaluateJob('success'), skippedSmoke],
    });
    expect(alarmObservation({ history, nowMs: NOW, armed: true })).toMatchObject({
      alarm: true,
      observed: true,
      incident: 'Smoke or dispatch',
    });
  });
});

describe('a fast-tier dispatch that runs in its own job', () => {
  const runs = [{ databaseId: 1, createdAt: daysAgo(1) }];
  const smoked = {
    name: "Smoke the fast-tier candidate's DMG",
    status: 'completed',
    conclusion: 'success',
    steps: [
      { name: "Download the candidate's DMG", conclusion: 'success' },
      { name: 'Smoke the DMG', conclusion: 'success' },
    ],
  };
  const dispatchJob = (conclusion, steps) => ({
    name: 'Dispatch the smoke-proven fast-tier candidate',
    status: 'completed',
    conclusion,
    steps,
  });
  const entryFor = (...jobs) => buildHistory({ runs, jobsForRun: () => jobs })[0];

  test('a dispatch job whose dispatch and receipt succeeded is a pass', () => {
    const jobs = [
      smoked,
      dispatchJob('success', [
        { name: 'Dispatch promote-stable for the smoke-proven candidate', conclusion: 'success' },
        { name: 'Record a successful fast-tier dispatch', conclusion: 'success' },
      ]),
    ];
    expect(entryFor(...jobs)).toEqual({ at: daysAgo(1), qualified: true, verdict: 'pass', promoted: true, failureStage: null });
  });

  test('a dispatch job skipped after a non-pass smoke is a qualified non-pass at the smoke stage', () => {
    expect(entryFor(smoked, dispatchJob('skipped', []))).toEqual({
      at: daysAgo(1),
      qualified: true,
      verdict: 'non-pass',
      promoted: false,
      failureStage: 'Smoke or dispatch',
    });
  });

  test('a dispatch the in-flight guard skipped did not qualify, as when the smoke job dispatched', () => {
    const jobs = [
      smoked,
      dispatchJob('success', [
        { name: 'Dispatch promote-stable for the smoke-proven candidate', conclusion: 'success' },
        { name: 'Record a successful fast-tier dispatch', conclusion: 'skipped' },
      ]),
    ];
    expect(entryFor(...jobs)).toMatchObject({ qualified: false, verdict: null, promoted: false });
  });

  test('a failed dispatch names the dispatch step as the failing stage', () => {
    const jobs = [
      smoked,
      dispatchJob('failure', [
        { name: 'Dispatch promote-stable for the smoke-proven candidate', conclusion: 'failure' },
        { name: 'Record a successful fast-tier dispatch', conclusion: 'skipped' },
      ]),
    ];
    expect(entryFor(...jobs)).toMatchObject({
      qualified: true,
      verdict: 'non-pass',
      failureStage: 'Dispatch promote-stable for the smoke-proven candidate',
    });
  });

  test('the step that reports a failed dispatch leaves the failing stage on the dispatch step', () => {
    const jobs = [
      smoked,
      dispatchJob('failure', [
        { name: 'Dispatch promote-stable for the smoke-proven candidate', conclusion: 'failure' },
        { name: 'Record a successful fast-tier dispatch', conclusion: 'skipped' },
        { name: 'Report a failed fast-tier dispatch', conclusion: 'success' },
      ]),
    ];
    const entry = entryFor(...jobs);
    expect(entry).toEqual({
      at: daysAgo(1),
      qualified: true,
      verdict: 'non-pass',
      promoted: false,
      failureStage: 'Dispatch promote-stable for the smoke-proven candidate',
    });
    expect(alarmObservation({ history: [entry, entry, entry], nowMs: NOW, armed: true })).toMatchObject({
      alarm: true,
      incident: 'Dispatch promote-stable for the smoke-proven candidate',
    });
  });

  test('the workflow puts the dispatch and its receipt in that job, gated on a passing smoke', () => {
    const { jobs } = parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'select-beta-to-promote.yml'), 'utf8'),
    );
    const named = (name) => Object.values(jobs).filter((job) => job.name === name);
    const [smoke] = named("Smoke the fast-tier candidate's DMG");
    const [dispatch] = named('Dispatch the smoke-proven fast-tier candidate');
    expect(named('Dispatch the smoke-proven fast-tier candidate')).toHaveLength(1);
    expect(dispatch.if).toBe("needs.smoke-fast-tier-candidate.outputs.verdict == 'pass'");
    const stepNames = (job) => job.steps.map((step) => step.name);
    expect(stepNames(dispatch)).toEqual(
      expect.arrayContaining(['Dispatch promote-stable for the smoke-proven candidate', 'Record a successful fast-tier dispatch']),
    );
    expect(stepNames(smoke)).not.toContain('Dispatch promote-stable for the smoke-proven candidate');
    expect(stepNames(smoke)).not.toContain('Record a successful fast-tier dispatch');
  });
});
