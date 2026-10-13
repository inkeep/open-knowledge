import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import stock from '../../../../playwright.config.ts';

const runDir = process.env.OK_REUSE_CASE_RUN_DIR;
if (!runDir) throw new Error('OK_REUSE_CASE_RUN_DIR is required');

export default defineConfig({
  ...stock,
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: /.*\.reuse-case\.ts$/,
  globalSetup: [fileURLToPath(new URL('./reuse-run.ts', import.meta.url))],
  outputDir: join(runDir, 'test-results'),
  reporter: [['json', { outputFile: join(runDir, 'results.json') }]],
  retries: 0,
  workers: 1,
  use: { ...stock.use, headless: true },
});
