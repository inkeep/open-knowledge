import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/a11y',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
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
