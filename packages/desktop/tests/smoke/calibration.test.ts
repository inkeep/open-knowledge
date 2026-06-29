import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePlaywrightConfigTimeout, parseTestFile } from './_helpers/parse-timeouts';

const DESKTOP_ROOT = resolve(__dirname, '..', '..');
const CONFIG_PATH = resolve(DESKTOP_ROOT, 'playwright.config.ts');
const SMOKE_DIR = resolve(DESKTOP_ROOT, 'tests', 'smoke');

const SMOKE_FILES = readdirSync(SMOKE_DIR)
  .filter((f) => f.endsWith('.e2e.ts'))
  .sort();

const TOPASS_BUDGET_FILES = ['deep-link.e2e.ts', 'external-link.e2e.ts'] as const;

const MIN_TOPASS_BUDGET_MS = 15_000;

describe('Playwright smoke test calibration', () => {
  describe('outer per-test timeout configuration', () => {
    test('playwright.config.ts has a parseable top-level timeout', () => {
      const cfg = parsePlaywrightConfigTimeout(CONFIG_PATH);
      expect(cfg.ci).toBeGreaterThan(0);
      expect(cfg.local).toBeGreaterThan(0);
    });
  });

  describe('Invariant A: cumulative inner timeouts fit within outer CI budget', () => {
    const cfg = parsePlaywrightConfigTimeout(CONFIG_PATH);
    const outerCiMs = cfg.ci;

    for (const file of SMOKE_FILES) {
      const filePath = resolve(SMOKE_DIR, file);
      const fa = parseTestFile(filePath);
      for (const t of fa.tests) {
        test(`${file}:${t.lineNumber} ${t.testName} cumulative ≤ outer CI`, () => {
          const budgetMs = t.perTestTimeoutMs ?? outerCiMs;
          const breakdown = {
            file,
            line: t.lineNumber,
            test: t.testName,
            cumulativeMs: t.cumulativeMs,
            budgetMs,
            budgetSource:
              t.perTestTimeoutMs != null ? 'test.setTimeout' : 'playwright.config.ts (CI)',
            directTimeoutsMs: t.directTimeoutsMs,
            helperCalls: t.helperCallNames,
            tracedHelperBudgetsMs: t.tracedHelperBudgetsMs,
          };
          if (t.cumulativeMs > budgetMs) {
            throw new Error(
              `cumulative inner-timeout budget exceeds per-test budget: ${JSON.stringify(breakdown, null, 2)}`,
            );
          }
          expect(t.cumulativeMs).toBeLessThanOrEqual(budgetMs);
        });
      }
    }
  });

  describe('Invariant B: Apple-Event / IPC toPass budgets meet minimum', () => {
    for (const file of TOPASS_BUDGET_FILES) {
      const filePath = resolve(SMOKE_DIR, file);
      const fa = parseTestFile(filePath);
      for (const t of fa.tests) {
        if (t.toPassBudgetsMs.length === 0) continue;
        test(`${file}:${t.lineNumber} ${t.testName} every toPass ≥ ${MIN_TOPASS_BUDGET_MS}ms`, () => {
          const undersized = t.toPassBudgetsMs.filter((b) => b < MIN_TOPASS_BUDGET_MS);
          if (undersized.length > 0) {
            throw new Error(
              `toPass({ timeout }) budget(s) below ${MIN_TOPASS_BUDGET_MS}ms minimum: ${JSON.stringify(
                {
                  file,
                  line: t.lineNumber,
                  test: t.testName,
                  toPassBudgetsMs: t.toPassBudgetsMs,
                  undersizedMs: undersized,
                  minRequiredMs: MIN_TOPASS_BUDGET_MS,
                },
                null,
                2,
              )}`,
            );
          }
          for (const b of t.toPassBudgetsMs) {
            expect(b).toBeGreaterThanOrEqual(MIN_TOPASS_BUDGET_MS);
          }
        });
      }
    }
  });
});
