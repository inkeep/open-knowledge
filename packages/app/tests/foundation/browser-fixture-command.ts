import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserCommand } from 'vitest/node';
import {
  APP_ROOT,
  type BrowserFixtureFile,
  type BrowserFixtureRequest,
  type BrowserFixtureRun,
  fixtureDeadlineMs,
  fixtureEnv,
  fixtureFilePaths,
  fixtureRunArguments,
  parseFixtureReport,
  unfinishedRunMessage,
} from './browser-fixture-run';
import { NESTED_RUN_STOP_GRACE_MS } from './nested-run-budget';

const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

function readReport(path: string): BrowserFixtureFile[] | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseFixtureReport(text);
}

export const runBrowserFixture: BrowserCommand<[BrowserFixtureRequest]> = (_context, request) => {
  const filePaths = fixtureFilePaths(request.files);
  const deadlineMs = fixtureDeadlineMs(request);
  const reportDir = mkdtempSync(join(tmpdir(), 'ok-browser-fixture-'));
  const reportPath = join(reportDir, 'report.json');
  return new Promise<BrowserFixtureRun>((resolveRun, rejectRun) => {
    let stopped = false;
    let deadline: NodeJS.Timeout | undefined;
    let forcedStop: NodeJS.Timeout | undefined;
    const child = execFile(
      process.execPath,
      fixtureRunArguments(filePaths, reportPath),
      {
        cwd: APP_ROOT,
        env: fixtureEnv(request, process.env, join(reportDir, 'node_modules', '.vite')),
        maxBuffer: OUTPUT_LIMIT_BYTES,
      },
      (error, stdout, stderr) => {
        clearTimeout(deadline);
        clearTimeout(forcedStop);
        try {
          if (stopped) {
            rejectRun(
              new Error(unfinishedRunMessage(request.files, deadlineMs, { stdout, stderr })),
            );
            return;
          }
          resolveRun({
            exitCode: typeof error?.code === 'number' ? error.code : error ? null : 0,
            files: readReport(reportPath),
            stdout,
            stderr,
          });
        } catch (failure) {
          rejectRun(failure);
        } finally {
          rmSync(reportDir, { recursive: true, force: true });
        }
      },
    );
    deadline = setTimeout(() => {
      stopped = true;
      child.kill('SIGTERM');
      forcedStop = setTimeout(() => child.kill('SIGKILL'), NESTED_RUN_STOP_GRACE_MS);
    }, deadlineMs);
  });
};
