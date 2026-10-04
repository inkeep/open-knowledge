import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Reporter } from 'vitest/node';
import { z } from 'zod';

const unavailable = z.object({
  name: z.literal('CliInstallUnavailableError'),
  exitCode: z.literal(77),
  acquisitionId: z.uuid(),
  outputBytes: z.number().int().nonnegative(),
});
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const eventSchema = z.object({
  pull_request: z.object({ base: z.object({ sha: commit }) }).optional(),
  merge_group: z.object({ base_sha: commit }).optional(),
});

function checkoutHead() {
  try {
    return commit.parse(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    );
  } catch (error) {
    const fallback = commit.safeParse(process.env.GITHUB_SHA);
    if (fallback.success) return fallback.data;
    process.stderr.write(
      `CLI acquisition result: checkout provenance unavailable: ${String(error)}\n`,
    );
    return null;
  }
}

function comparisonBase() {
  try {
    const event = process.env.GITHUB_EVENT_PATH
      ? eventSchema.parse(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')))
      : undefined;
    const base =
      event?.pull_request?.base.sha ?? event?.merge_group?.base_sha ?? process.env.GITHUB_BASE_SHA;
    return base === undefined ? null : commit.parse(base);
  } catch (error) {
    process.stderr.write(
      `CLI acquisition result: comparison provenance unavailable: ${String(error)}\n`,
    );
    return null;
  }
}

export default class InstallOutcomeReporter implements Reporter {
  onTestRunEnd: NonNullable<Reporter['onTestRunEnd']> = (modules, errors, reason) => {
    if (reason !== 'failed') return;
    if (modules.some((module) => [...module.children.allTests('failed')].length > 0)) return;
    const failures = [
      ...errors,
      ...modules.flatMap((module) => [
        ...module.errors(),
        ...[...module.children.allSuites()].flatMap((suite) => suite.errors()),
      ]),
    ];
    const acquisitions = z.array(unavailable).nonempty().safeParse(failures);
    if (!acquisitions.success) return;
    const outputBytes = [
      ...new Map(
        acquisitions.data.map(({ acquisitionId, outputBytes }) => [acquisitionId, outputBytes]),
      ).values(),
    ].reduce((total, bytes) => total + bytes, 0);
    process.stderr.write(
      `INKEEP_GATE_RESULT_V1 ${JSON.stringify({
        boundary: 'round',
        class: 'not-run',
        exit: 77,
        signal: null,
        outputBytes,
        runId: randomUUID(),
        head: checkoutHead(),
        base: comparisonBase(),
        subject: 'cli-e2e',
        step: 'packed-install',
        reasonCode: 'registry-unavailable',
      })}\n`,
    );
    process.exitCode = 77;
  };
}
