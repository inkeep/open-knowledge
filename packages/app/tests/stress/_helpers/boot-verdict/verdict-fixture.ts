import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from '@playwright/test';
import { test as stressTest, type WorkerServer } from '../fixtures.ts';
import { declareSetupNonResult } from '../setup-non-result.ts';

const INJECT_BOOT_FAILURE = pathToFileURL(join(import.meta.dirname, 'inject-boot-failure.ts')).href;

function requireRunDir(): string {
  const runDir = process.env.OK_BOOT_VERDICT_RUN_DIR;
  if (runDir === undefined) {
    throw new Error(
      'OK_BOOT_VERDICT_RUN_DIR is unset; run these cases through verdict-run.config.ts',
    );
  }
  return runDir;
}

function unlaunchedBrowser(): Browser {
  return new Proxy(Object.create(null) as Browser, {
    get(_target, member) {
      throw new Error(`the boot-verdict cases launch no browser, yet ${String(member)} was read`);
    },
  });
}

function undialledWorkerServer(): WorkerServer {
  return { port: 0, baseURL: 'http://127.0.0.1:0', contentDir: requireRunDir() };
}

const verdictTest = stressTest.extend({
  browser: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
    async ({}, use) => {
      await use(unlaunchedBrowser());
    },
    { scope: 'worker' },
  ],
});

export const bootFailureTest = verdictTest.extend({
  workerServerEnv: [
    { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${INJECT_BOOT_FAILURE}` },
    { scope: 'worker' },
  ],
});

export const bootedTest = verdictTest.extend({
  workerServer: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
    async ({}, use) => {
      await use(undialledWorkerServer());
    },
    { scope: 'worker' },
  ],
});

export const setupRecoveredOnRetryTest = verdictTest.extend({
  workerServer: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
    async ({}, use) => {
      const testInfo = verdictTest.info();
      if (testInfo.retry === 0) {
        const reason =
          'OK_BOOT_VERDICT: the first attempt declares its setup incomplete before dialling any server';
        declareSetupNonResult(testInfo, reason);
        throw new Error(reason);
      }
      await use(undialledWorkerServer());
    },
    { scope: 'worker' },
  ],
});

export function recordBodyRan(caseName: string, detail = ''): void {
  appendFileSync(join(requireRunDir(), `body-ran.${caseName}`), `${process.pid} ${detail}\n`);
}
