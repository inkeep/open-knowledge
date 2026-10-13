import { defineConfig } from '@playwright/test';
import ordinary from './playwright.config.ts';

const directory = process.env.OK_TEST_LIFETIME_DIR;
if (directory === undefined) throw new Error('OK_TEST_LIFETIME_DIR is required');

export default defineConfig({
  ...ordinary,
  testDir: `${directory}/cases`,
  workers: 2,
  retries: 0,
});
