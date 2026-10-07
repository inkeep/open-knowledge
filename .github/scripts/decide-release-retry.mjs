/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions invokes this entrypoint directly, outside Turbo. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions } from './write-back-gate.mjs';

export const RETRYABLE_OUTCOMES = Object.freeze([
  'transient-exhausted',
  'deadline',
  'signal',
  'attempt-timeout',
]);

const JOB_TIMEOUT = /^The job has exceeded the maximum execution time of /;

const RETRYABLE_INFRASTRUCTURE = Object.freeze([
  /^The hosted runner lost communication with the server\./,
  /^Failed to FinalizeArtifact\b/,
  /gh release upload failed after \d+ attempts/,
  JOB_TIMEOUT,
]);

const PLATFORM_JOBS = Object.freeze([
  ['mac', /^build-macos\b/],
  ['windows', /^build-windows\b/],
  ['linux', /^build-linux\b/],
]);
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out']);
const TIMEOUT_CANCELLATION = 'The operation was canceled.';
const GENERIC_EXIT = /^Process completed with exit code \d+\.$/;
const STOP_LINE = /\bdecision=stop reason=(\S+) outcome=(\S+)/;

function firstLine(message) {
  return String(message).split('\n')[0].slice(0, 160);
}

function judgeFailure(message) {
  if (GENERIC_EXIT.test(message)) return { kind: 'generic' };
  const stop = STOP_LINE.exec(message);
  if (stop) {
    const [, reason, outcome] = stop;
    const cause = `outcome=${outcome} reason=${reason}`;
    const retryable =
      RETRYABLE_OUTCOMES.includes(outcome) ||
      (outcome === 'terminal' && reason === 'rule:download-integrity');
    return { kind: retryable ? 'retryable' : 'blocking', cause };
  }
  if (RETRYABLE_INFRASTRUCTURE.some((pattern) => pattern.test(message))) {
    return { kind: 'retryable', cause: firstLine(message) };
  }
  return { kind: 'blocking', cause: firstLine(message) };
}

export function classifyFailedJob(annotations) {
  const messages = (annotations ?? [])
    .filter((annotation) => annotation.level === 'failure')
    .map((annotation) => annotation.message);
  const timedOut = messages.some((message) => JOB_TIMEOUT.test(message));
  const judged = messages.map((message) => {
    if (timedOut && message === TIMEOUT_CANCELLATION) return { kind: 'generic' };
    return judgeFailure(message);
  });
  const blocking = judged.find((judgement) => judgement.kind === 'blocking');
  if (blocking) return { retryable: false, cause: blocking.cause };
  const retryable = judged.find((judgement) => judgement.kind === 'retryable');
  if (retryable) return { retryable: true, cause: retryable.cause };
  return { retryable: false, cause: 'no recognized cause in its annotations' };
}

function isRequired(jobName, requiredPlatforms) {
  const platform = PLATFORM_JOBS.find(([, pattern]) => pattern.test(jobName))?.[0];
  return platform === undefined || requiredPlatforms.includes(platform);
}

export function decideRetry({
  tag,
  channel,
  runAttempt,
  smokeVerdict,
  latestStable,
  jobs,
  requiredPlatforms = ['mac', 'windows', 'linux'],
}) {
  const page = (reason) => ({ action: 'page', reason });
  if (channel !== 'latest') return page(`channel ${channel || 'unknown'} is not a stable cut`);
  if (smokeVerdict === 'fail') return page('the packaged app failed the DMG smoke');
  if (latestStable && compareVersions(latestStable, tag) > 0) {
    return page(`a newer stable ${latestStable} has already shipped`);
  }
  if (runAttempt > 1) return page(`attempt ${runAttempt} is already a re-run`);
  const failed = (jobs ?? []).filter(
    (job) => FAILED_CONCLUSIONS.has(job.conclusion) && isRequired(job.name, requiredPlatforms),
  );
  if (failed.length === 0) return page('no failed job to re-run');
  const judged = failed.map((job) => ({ name: job.name, ...classifyFailedJob(job.annotations) }));
  const blocking = judged.filter((job) => !job.retryable);
  if (blocking.length > 0) {
    return page(blocking.map((job) => `${job.name}: ${job.cause}`).join('; '));
  }
  return {
    action: 'retry',
    reason: judged.map((job) => `${job.name}: ${job.cause}`).join('; '),
  };
}

async function github(path, token, { allowNotFound = false } = {}) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const response = await fetch(`${api}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status})`);
  return response.json();
}

async function readJobs({ repo, runId, runAttempt, token }) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const body = await github(
      `/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
      token,
    );
    jobs.push(...body.jobs);
    if (jobs.length >= body.total_count || body.jobs.length === 0) break;
  }
  return Promise.all(
    jobs.map(async (job) => ({
      name: job.name,
      conclusion: job.conclusion,
      annotations: FAILED_CONCLUSIONS.has(job.conclusion)
        ? (await github(`/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`, token)).map(
            (annotation) => ({ level: annotation.annotation_level, message: annotation.message }),
          )
        : [],
    })),
  );
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT || '1');
  const token = process.env.GH_TOKEN;
  const tag = process.env.RELEASE_TAG;
  if (!repo || !runId || !token || !tag) {
    throw new Error('GITHUB_REPOSITORY, GITHUB_RUN_ID, GH_TOKEN and RELEASE_TAG are required');
  }
  const latest = await github(`/repos/${repo}/releases/latest`, token, { allowNotFound: true });
  const decision = decideRetry({
    tag,
    channel: process.env.CHANNEL,
    runAttempt,
    smokeVerdict: process.env.SMOKE_VERDICT,
    latestStable: latest?.tag_name ?? null,
    jobs: await readJobs({ repo, runId, runAttempt, token }),
    requiredPlatforms: process.env.REQUIRED_PLATFORMS
      ? process.env.REQUIRED_PLATFORMS.split(',').map((platform) => platform.trim())
      : undefined,
  });
  const reason = decision.reason.replace(/\s+/g, ' ');
  if (decision.action === 'retry') {
    console.log(
      `::warning::RELEASE RETRYING: ${tag} — the failed jobs re-run once automatically; a second failure pages. ${reason}`,
    );
  } else {
    console.log(`::notice::No automatic re-run for ${tag}: ${reason}`);
  }
  if (process.env.DECISION_PATH) {
    mkdirSync(dirname(process.env.DECISION_PATH), { recursive: true });
    writeFileSync(
      process.env.DECISION_PATH,
      JSON.stringify({ tag, runId, runAttempt, ...decision, reason }),
    );
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `action=${decision.action}\nreason=${reason}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::warning::Automatic re-run decision failed; paging instead. ${error.message}`);
    process.exitCode = 1;
  });
}
