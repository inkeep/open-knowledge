import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { expect as baseExpect, test as baseTest, type ElectronApplication } from '@playwright/test';
import { captureAppProcess, closeAppBounded, reapDetachedServers } from './electron-cleanup';
import {
  attachCapturedStderr,
  captureElectronStderr,
  type ElectronStderrCapture,
  shouldAttachStderr,
} from './electron-stderr';

export interface SmokeRegistrationOpts {
  cleanupDirs?: readonly string[];
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
    await use((app, opts) => {
      captures.push(captureElectronStderr(app));
      procs.push(captureAppProcess(app));
      if (opts?.cleanupDirs) {
        for (const dir of opts.cleanupDirs) cleanupDirs.push(dir);
      }
    });
    if (shouldAttachStderr(testInfo)) {
      await attachCapturedStderr(testInfo, captures);
    }
    for (const proc of procs) {
      await closeAppBounded(proc, { gracefulMs: 5_000 });
    }
    reapDetachedServers(cleanupDirs);
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[smoke-test] tmp-dir cleanup failed for ${dir}: ${reason}`);
      }
    }
  },
});

export const expect = baseExpect;
