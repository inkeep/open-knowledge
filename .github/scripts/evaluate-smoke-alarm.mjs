#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONSECUTIVE_NON_PASS_THRESHOLD = 3;
export const STALE_FAST_TIER_WINDOW_DAYS = 14;

const SMOKE_JOB_NAME = "Smoke the fast-tier candidate's DMG";
const DISPATCH_STEP_NAME = 'Dispatch promote-stable for the smoke-proven candidate';

export function evaluateAlarm({
  history,
  nowMs,
  armed = true,
  consecutiveThreshold = CONSECUTIVE_NON_PASS_THRESHOLD,
  windowDays = STALE_FAST_TIER_WINDOW_DAYS,
}) {
  const reasons = [];
  if (!armed) return { alarm: false, reasons };
  const qualified = history.filter((h) => h.qualified);

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

  return { alarm: reasons.length > 0, reasons };
}

export function buildHistory({ runs, jobsForRun }) {
  return runs.map((run) => {
    const jobs = jobsForRun(run.databaseId ?? run.id) ?? [];
    const smoke = jobs.find((j) => j.name === SMOKE_JOB_NAME);
    if (!smoke || smoke.conclusion === 'skipped' || smoke.conclusion === 'cancelled') {
      return { at: run.createdAt, qualified: false, verdict: null, promoted: false };
    }
    const dispatch = (smoke.steps ?? []).find((s) => s.name === DISPATCH_STEP_NAME);
    const promoted = dispatch?.conclusion === 'success';
    return {
      at: run.createdAt,
      qualified: true,
      verdict: promoted ? 'pass' : 'non-pass',
      promoted,
    };
  });
}

const TRANSIENT_HISTORY_FAILURE =
  /timeout|timed out|rate.?limit|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|\b5\d{2}\b|Bad Gateway|Service Unavailable/i;

export function classifyHistoryFailure(message) {
  return TRANSIENT_HISTORY_FAILURE.test(String(message ?? '')) ? '::notice::' : '::warning::';
}

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
    console.log(
      `${classifyHistoryFailure(err?.message ?? String(err))}Could not read run history for the aggregate alarm: ${err?.message ?? String(err)}`,
    );
  }

  const armed = process.env.FAST_TIER_ARMED === 'true';
  const { alarm, reasons } = evaluateAlarm({ history, nowMs: Date.now(), armed });
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
