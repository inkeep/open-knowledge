#!/usr/bin/env node
/**
 * Aggregate alarm for a silently-broken DMG smoke gate.
 *
 * A per-cut alert covers a gate that BITES. It does not cover the failure mode
 * that actually worries us: a gate that is quietly always-refusing, or a fast
 * tier that has gone inert. Both look identical to a calm week — everything
 * green, nothing shipping early, nobody notices. This evaluator watches the
 * aggregate and pages when the pattern, rather than any single cut, is wrong.
 *
 * Two conditions:
 *   1. Three consecutive fast-tier-qualified cuts whose verdict was not `pass`.
 *      One bad DMG is news; three in a row is a broken gate.
 *   2. No fast-tier promotion in a rolling 14-day window in which at least one
 *      cut DID qualify. The tier is armed and reaching nothing.
 *
 * And one deliberate non-condition: if NO cut in the window qualified, nothing
 * fires. An intentionally disarmed fast tier is not a broken one, and an alarm
 * that screams continuously while the tier is off would train responders to
 * ignore it — which would cost us the two real conditions above.
 *
 * Stateless. History comes from queryable workflow-run state; nothing is
 * written back to the repository.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONSECUTIVE_NON_PASS_THRESHOLD = 3;
export const STALE_FAST_TIER_WINDOW_DAYS = 14;

const SMOKE_JOB_NAME = "Smoke the fast-tier candidate's DMG";
const DISPATCH_STEP_NAME = 'Dispatch promote-stable for the smoke-proven candidate';

/**
 * @param history newest-first list of `{ at, qualified, verdict, promoted }`.
 *   `qualified` — the cut satisfied the fast-tier predicate, so the gate was
 *   asked for an opinion. `verdict` — 'pass' | 'fail' | 'error' | null.
 *   `promoted` — a fast-tier promotion actually fired.
 * @returns `{ alarm, reasons }` — `reasons` is empty when `alarm` is false.
 */
export function evaluateAlarm({
  history,
  nowMs,
  consecutiveThreshold = CONSECUTIVE_NON_PASS_THRESHOLD,
  windowDays = STALE_FAST_TIER_WINDOW_DAYS,
}) {
  const reasons = [];
  const qualified = history.filter((h) => h.qualified);

  // Condition 1 — leading run of non-pass verdicts among qualified cuts.
  let streak = 0;
  for (const cut of qualified) {
    if (cut.verdict === 'pass') break;
    streak += 1;
  }
  if (streak >= consecutiveThreshold) {
    reasons.push(
      `${streak} consecutive fast-tier candidates did not pass the DMG smoke (threshold ${consecutiveThreshold}) — the gate looks persistently broken, not merely unlucky`,
    );
  }

  // Condition 2 — armed but never promoting, over a rolling window.
  const windowStart = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = history.filter((h) => {
    const t = Date.parse(h.at);
    return !Number.isNaN(t) && t >= windowStart;
  });
  const qualifiedInWindow = inWindow.filter((h) => h.qualified);
  if (qualifiedInWindow.length > 0 && !inWindow.some((h) => h.promoted)) {
    reasons.push(
      `${qualifiedInWindow.length} cut(s) qualified for the fast tier in the last ${windowDays} days but none was promoted through it — the tier is armed and reaching nothing`,
    );
  }
  // The disarmed case needs no branch: with nothing qualified, condition 1's
  // streak is 0 and condition 2's guard is false, so both stay silent.

  return { alarm: reasons.length > 0, reasons };
}

// --- workflow-runtime wiring (real gh boundary) ---

/**
 * Build history from the selection workflow's own run history. A run that never
 * reached the smoke job did not qualify; a run whose smoke job ran tells us its
 * verdict via whether the dispatch step executed or was skipped.
 */
export function buildHistory({ runs, jobsForRun }) {
  return runs.map((run) => {
    const jobs = jobsForRun(run.databaseId ?? run.id) ?? [];
    const smoke = jobs.find((j) => j.name === SMOKE_JOB_NAME);
    if (!smoke || smoke.conclusion === 'skipped') {
      return { at: run.createdAt, qualified: false, verdict: null, promoted: false };
    }
    const dispatch = (smoke.steps ?? []).find((s) => s.name === DISPATCH_STEP_NAME);
    const promoted = dispatch?.conclusion === 'success';
    // The jobs API cannot distinguish `fail` from `error` — that lives in the
    // job's step output, which is not queryable after the fact. `non-pass` is
    // the honest label, and it is all either alarm condition needs.
    return {
      at: run.createdAt,
      qualified: true,
      verdict: promoted ? 'pass' : 'non-pass',
      promoted,
    };
  });
}

/**
 * Signatures of a failure that a later tick can plausibly recover from on its
 * own. Everything else is treated as permanent and warned about, because a
 * permanently-broken history reader makes this evaluator silently inert.
 */
const TRANSIENT_HISTORY_FAILURE =
  /timeout|timed out|rate.?limit|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|\b5\d{2}\b|Bad Gateway|Service Unavailable/i;

export function classifyHistoryFailure(message) {
  return TRANSIENT_HISTORY_FAILURE.test(String(message ?? '')) ? '::notice::' : '::warning::';
}

/**
 * `buildHistory` makes up to 60 serial calls through here. `execFileSync` has
 * no socket timeout of its own, so one stalled API response would consume the
 * job's whole 10-minute budget — and a timed-out job writes no GITHUB_OUTPUT,
 * leaving `alarm` empty and silently skipping the page step. A per-call cap
 * bounds the worst case, and the resulting ETIMEDOUT is already in the
 * transient set.
 */
const GH_CALL_TIMEOUT_MS = 30_000;

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: GH_CALL_TIMEOUT_MS }));
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'inkeep/open-knowledge';
  let history = [];
  try {
    const runs = ghJson([
      'run',
      'list',
      '--workflow=select-beta-to-promote.yml',
      '--limit',
      '60',
      '--json',
      'databaseId,createdAt',
    ]);
    history = buildHistory({
      runs,
      jobsForRun: (id) => ghJson(['api', `repos/${repo}/actions/runs/${id}/jobs`]).jobs,
    });
  } catch (err) {
    // An unreadable history is not an alarm — this evaluator is itself
    // best-effort observability, and a gh outage must not page anyone. But a
    // PERMANENT failure (expired auth, gh dropped from the runner image, a
    // misconfigured repo) would otherwise print the same reassuring notice on
    // every tick forever, leaving a dead alarm looking healthy — which is the
    // exact silent-failure shape this evaluator exists to detect. Split the
    // two so only the transient class is quiet.
    console.log(
      `${classifyHistoryFailure(err?.message ?? String(err))}Could not read run history for the aggregate alarm: ${err?.message ?? String(err)}`,
    );
  }

  const { alarm, reasons } = evaluateAlarm({ history, nowMs: Date.now() });
  if (!alarm) {
    console.log('No aggregate smoke alarm: the fast tier is either healthy or intentionally off.');
  } else {
    for (const reason of reasons) {
      console.log(`::warning::Aggregate smoke alarm — ${reason}`);
    }
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `alarm=${alarm}\nreasons=${reasons.join('; ').replace(/\r?\n/g, ' ')}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
