import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/visual',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  retries: 0,
  updateSnapshots: 'none',
  fullyParallel: true,
  workers: isCI ? 4 : undefined,
  use: {
    headless: true,
  },
});
