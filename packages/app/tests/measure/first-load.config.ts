import { defineConfig } from '@playwright/test';
import suiteConfig from '../../playwright.config.ts';

export default defineConfig({
  testDir: '.',
  testMatch: /first-load\.measure\.ts$/,
  globalSetup: [
    '../stress/_helpers/i18n-catalog-freshness.ts',
    '../stress/_helpers/global-warm-cache.ts',
  ],
  timeout: 300_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [['list']],
  use: suiteConfig.use,
});
