import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { expect as baseExpect, test as baseTest, type ElectronApplication } from '@playwright/test';
import { captureAppProcess, closeAppBounded } from './electron-cleanup';
import {
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
      for (const capture of captures) {
        await capture.attachTo(testInfo);
      }
    }
    for (const proc of procs) {
      await closeAppBounded(proc, { gracefulMs: 5_000 });
    }
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  },
});

export const expect = baseExpect;
