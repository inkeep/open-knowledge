import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import stock from '../../../../playwright.config.ts';

const runDir = process.env.OK_ASSERTION_TIMEOUT_RUN_DIR;
if (!runDir) throw new Error('OK_ASSERTION_TIMEOUT_RUN_DIR is required');

export default defineConfig({
  ...stock,
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: /.*\.assertion-timeout-case\.ts$/,
  globalSetup: [],
  globalTimeout: 60_000,
  outputDir: join(runDir, 'test-results'),
  reporter: [['json', { outputFile: join(runDir, 'results.json') }]],
  retries: 0,
  workers: 1,
  use: { ...stock.use, headless: true, video: 'off', trace: 'off', screenshot: 'off' },
});
