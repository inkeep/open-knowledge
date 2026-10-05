import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import stock from '../../../../playwright.config.ts';

const runDir = process.env.OK_PORT_OWNERSHIP_RUN_DIR;
if (!runDir) throw new Error('OK_PORT_OWNERSHIP_RUN_DIR is required');
const stressDir = fileURLToPath(new URL('../..', import.meta.url));
const warmCacheSetup = fileURLToPath(new URL('../global-warm-cache.ts', import.meta.url));
const lifetimeSetup = fileURLToPath(new URL('./lifetime-global-setup.ts', import.meta.url));
const caller = process.env.OK_PORT_OWNERSHIP_CALLER;

export default defineConfig({
  ...stock,
  testDir: stressDir,
  testMatch: [/.*\.e2e\.ts$/, /.*\.ownership-case\.ts$/],
  globalSetup:
    caller === 'global-warm-cache.ts'
      ? [warmCacheSetup]
      : caller?.startsWith('lifetime-')
        ? [lifetimeSetup]
        : [],
  globalTimeout: caller?.startsWith('lifetime-') ? 5_000 : 110_000,
  outputDir: join(runDir, 'test-results'),
  reporter: [['json', { outputFile: join(runDir, 'results.json') }]],
  retries: 0,
  workers: 2,
  use: { ...stock.use, headless: true },
});
