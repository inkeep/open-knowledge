import { defineConfig } from '@playwright/test';


export default defineConfig({
  testDir: './tests/smoke',
  testMatch: /.*\.e2e\.ts$/,
  testIgnore: ['**/_*.e2e.ts'],
  timeout: process.env.CI ? 150_000 : 60_000,
  retries: process.env.CI ? 2 : 0,
  failOnFlakyTests: false,
  globalSetup: './tests/smoke/_helpers/stale-build-guard.ts',
  workers: 1,
  fullyParallel: false,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/desktop-smoke-results.json' }],
  ],
  use: {
    trace: 'retain-on-failure',
  },
});
