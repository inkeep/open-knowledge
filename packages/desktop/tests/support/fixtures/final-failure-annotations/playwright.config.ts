import { env } from 'node:process';
import { defineConfig } from '@playwright/test';
import { FINAL_FAILURE_ANNOTATIONS } from '../../../../../../test-support/playwright-final-failure-annotations.ts';

export default defineConfig({
  testDir: '.',
  testMatch: /\.fixture-spec\.ts$/,
  outputDir: env.FINAL_FAILURE_FIXTURE_OUTPUT_DIR,
  retries: 2,
  retryStrategy: env.FINAL_FAILURE_FIXTURE_ISOLATED_RETRIES === '1' ? 'isolated' : 'immediate',
  workers: 1,
  reporter: [[FINAL_FAILURE_ANNOTATIONS]],
  globalSetup:
    env.FINAL_FAILURE_FIXTURE_SETUP_FAILS === '1' ? './failing-global-setup.ts' : undefined,
});
