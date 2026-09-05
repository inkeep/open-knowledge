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
import {
  type BootGapLine,
  bootGapSourceFor,
  bootLogGapSummary,
  describeMissingBootLog,
  formatBootGapLine,
  readBootLog,
  readyWaitsFor,
  rememberLaunchHome,
  tryBootLogFor,
  tryFirstWaitFor,
  tryLaunchHomeFor,
} from './launch-readiness';

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
    const homes = apps.map((app) => tryLaunchHomeFor(app));
    for (const [slot, app] of apps.entries()) {
      const home = homes[slot];
      if (home === undefined) continue;
      const suffix = `-slot${slot}`;
      const atBoot = tryBootLogFor(app);
      const onDisk = readBootLog(home);
      const lines = atBoot ?? onDisk.lines;
      const readyWaits = readyWaitsFor(app);
      const firstWait = tryFirstWaitFor(app);
      const gap: BootGapLine = {
        slot,
        source: bootGapSourceFor({
          hasLines: lines.length > 0,
          snapshotted: atBoot !== undefined,
          homeShared: homes.filter((h) => h === home).length > 1,
        }),
        readyWaitCount: readyWaits?.length ?? 0,
        ...(firstWait === undefined ? {} : { firstWait }),
        summary: lines.length > 0 ? bootLogGapSummary(lines) : undefined,
      };
      if (gap.summary === undefined) gap.reason = describeMissingBootLog(onDisk);
      console.log(formatBootGapLine(gap));
      try {
        await testInfo.attach(`boot-log-gaps${suffix}`, {
          body: JSON.stringify(gap, null, 2),
          contentType: 'application/json',
        });
        if (lines.length > 0 && shouldAttachStderr(testInfo)) {
          await testInfo.attach(`boot-log${suffix}`, {
            body: lines.join('\n'),
            contentType: 'text/plain',
          });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[smoke-test] boot-log attach failed: ${reason}`);
      }
    }
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
