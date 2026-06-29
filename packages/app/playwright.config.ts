import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/stress',
  testMatch: /.*\.e2e\.ts$/,
  globalSetup: './tests/stress/_helpers/global-warm-cache.ts',
  timeout: 120_000,
  expect: { timeout: isCI ? 15_000 : 5_000 },
  retries: isCI ? 2 : 0,
  failOnFlakyTests: false,
  forbidOnly: isCI,
  fullyParallel: true,
  workers: isCI ? 4 : undefined,
  reporter: [['html', { open: 'never' }], ['list'], ...(isCI ? [['github'] as const] : [])],
  use: {
    headless: true,
    video: { mode: 'retain-on-failure', size: { width: 1280, height: 720 } },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
