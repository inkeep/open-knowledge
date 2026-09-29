import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { expect as baseExpect, test as baseTest, type ElectronApplication } from '@playwright/test';
import { emitBootGapLines } from './boot-gap-emit';
import {
  captureAppProcess,
  cleanupIncompleteReport,
  closeAppsThenAwaitServerRelease,
} from './electron-cleanup';
import {
  attachCapturedStderr,
  captureElectronStderr,
  type ElectronStderrCapture,
  shouldAttachStderr,
} from './electron-stderr';
import { rememberLaunchHome } from './launch-readiness';

export interface SmokeRegistrationOpts {
  cleanupDirs?: readonly string[];
  home?: string;
}

export interface SmokeFixtures {
  captureStderrFor: (app: ElectronApplication, opts?: SmokeRegistrationOpts) => void;
}

export const test = baseTest.extend<SmokeFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
  captureStderrFor: async ({}, use, testInfo) => {
    const captures: ElectronStderrCapture[] = [];
    const procs: ChildProcess[] = [];
    const cleanupDirs: string[] = [];
    const apps: ElectronApplication[] = [];
    await use((app, opts) => {
      captures.push(captureElectronStderr(app));
      procs.push(captureAppProcess(app));
      apps.push(app);
      if (opts?.home !== undefined) rememberLaunchHome(app, opts.home);
      if (opts?.cleanupDirs) {
        for (const dir of opts.cleanupDirs) cleanupDirs.push(dir);
      }
    });
    await emitBootGapLines(apps, testInfo);
    const { unclosed, survivors, closedAfterServerRelease } = await closeAppsThenAwaitServerRelease(
      procs,
      cleanupDirs,
      { gracefulMs: 5_000 },
    );
    for (const pid of closedAfterServerRelease) {
      console.log(
        `[smoke-test] app pid ${pid} closed only after the detached servers under its dirs released`,
      );
    }
    const report = cleanupIncompleteReport(unclosed, survivors);
    if (report !== undefined) {
      try {
        await testInfo.attach('app-cleanup-incomplete', {
          body: report,
          contentType: 'text/plain',
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[smoke-test] cleanup-diagnostic attach failed: ${reason}`);
      }
    }
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[smoke-test] tmp-dir cleanup failed for ${dir}: ${reason}`);
      }
    }
    if (shouldAttachStderr(testInfo) || unclosed.length > 0) {
      await attachCapturedStderr(testInfo, captures);
    }
    if (unclosed.length > 0) {
      for (const error of unclosed) {
        console.error(`[smoke-test] cleanup incomplete: ${error.message}`);
      }
      throw new AggregateError(
        unclosed,
        `[smoke-test] ${unclosed.length} app process(es) did not close`,
      );
    }
  },
});

export const expect = baseExpect;
