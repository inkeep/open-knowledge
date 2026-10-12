import { defineConfig } from '@playwright/test';
import smoke from './playwright.config.ts';

export default defineConfig({
  ...smoke,
  testDir: './tests/smoke',
  testMatch: /.*\.capture\.ts$/,
  retries: 0,
  reporter: [['list']],
});
