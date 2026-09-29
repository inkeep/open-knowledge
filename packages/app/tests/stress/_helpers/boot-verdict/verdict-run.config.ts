import { join } from 'node:path';
import { defineConfig, type ReporterDescription } from '@playwright/test';
import stock from '../../../../playwright.config.ts';

const runDir = process.env.OK_BOOT_VERDICT_RUN_DIR;
const livenessBoundMs = Number(process.env.OK_BOOT_VERDICT_LIVENESS_BOUND_MS);
if (runDir === undefined || !Number.isFinite(livenessBoundMs) || livenessBoundMs <= 0) {
  throw new Error(
    'verdict-run.config.ts needs OK_BOOT_VERDICT_RUN_DIR and a positive OK_BOOT_VERDICT_LIVENESS_BOUND_MS',
  );
}

function stockReporters(): ReporterDescription[] {
  if (!Array.isArray(stock.reporter)) {
    throw new Error(
      `the stock playwright config declares its reporters as ${JSON.stringify(stock.reporter)}, not as a list this run can extend`,
    );
  }
  return stock.reporter;
}

export default defineConfig({
  ...stock,
  testDir: import.meta.dirname,
  testMatch: /\.verdict-case\.ts$/,
  globalSetup: [],
  globalTimeout: livenessBoundMs,
  outputDir: join(runDir, 'test-results'),
  reporter: [...stockReporters(), ['json', { outputFile: join(runDir, 'results.json') }]],
});
