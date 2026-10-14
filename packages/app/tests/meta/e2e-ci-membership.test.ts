import { readdirSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isTestOnlySourceFile } from '../../../../test-support/test-only-source-file.mjs';
import playwrightConfig from '../../playwright.config';
import { E2E_CI_EXCLUSIONS } from '../stress/e2e-ci-ledger';

const APP_ROOT = join(import.meta.dirname, '..', '..');
const STRESS_DIR = join(APP_ROOT, 'tests', 'stress');
const PKG_JSON_PATH = join(APP_ROOT, 'package.json');

function listStressE2eFiles(): string[] {
  return readdirSync(STRESS_DIR)
    .filter((name) => isTestOnlySourceFile(name, 'playwright'))
    .sort();
}

function specFilterTokens(script: string): string[] {
  return script
    .split(/\s+/)
    .filter((token) => isTestOnlySourceFile(token, 'playwright') || token.startsWith('tests/'));
}

function ignoredFiles(onDisk: readonly string[], patterns: readonly string[]): string[] {
  return onDisk.filter((file) =>
    patterns.some((pattern) => matchesGlob(`tests/stress/${file}`, pattern)),
  );
}

function testIgnorePatterns(): string[] {
  const { testIgnore } = playwrightConfig;
  if (testIgnore === undefined) return [];
  const patterns = Array.isArray(testIgnore) ? testIgnore : [testIgnore];
  return patterns.map((pattern) => {
    if (typeof pattern !== 'string') {
      throw new Error(`testIgnore must hold glob strings, one per ledger entry, got ${pattern}`);
    }
    return pattern;
  });
}

describe('test:e2e membership meta-guard', () => {
  test('the test:e2e script names no spec files, so Playwright discovery decides membership', () => {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.['test:e2e'] ?? '';
    expect(script).toMatch(/^playwright test/);
    expect(
      specFilterTokens(script),
      'test:e2e must not list spec files: Playwright file arguments are filters, so a new spec ' +
        'would silently miss CI. Exclude a spec through packages/app/tests/stress/e2e-ci-ledger.ts.',
    ).toEqual([]);
  });

  test('playwright.config.ts ignores exactly the ledgered stress files', () => {
    const onDisk = listStressE2eFiles();
    expect(onDisk.length).toBeGreaterThan(0);
    const ledgered = E2E_CI_EXCLUSIONS.map((entry) => entry.file).sort();
    expect(
      ignoredFiles(onDisk, testIgnorePatterns()),
      'testIgnore in packages/app/playwright.config.ts must skip exactly the files in ' +
        'packages/app/tests/stress/e2e-ci-ledger.ts. Add or remove a glob together with its ledger ' +
        'entry; if a ledgered file is gone from tests/stress, delete both.',
    ).toEqual(ledgered);
  });

  test('ledger entries are unique and carry non-empty reason + evidence', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const entry of E2E_CI_EXCLUSIONS) {
      if (seen.has(entry.file)) problems.push(`  duplicate entry: ${entry.file}`);
      seen.add(entry.file);
      if (entry.reason.trim() === '') problems.push(`  empty reason: ${entry.file}`);
      if (entry.evidence.trim() === '') problems.push(`  empty evidence: ${entry.file}`);
    }
    expect(problems, `Ledger hygiene violation(s):\n${problems.join('\n')}`).toEqual([]);
  });

  test('specFilterTokens flags spec paths and ignores flags', () => {
    expect(specFilterTokens('playwright test')).toEqual([]);
    expect(specFilterTokens('playwright test --workers=2 --grep foo')).toEqual([]);
    expect(
      specFilterTokens('playwright test tests/stress/a.e2e.ts b.e2e.ts tests/stress/ --retries=0'),
    ).toEqual(['tests/stress/a.e2e.ts', 'b.e2e.ts', 'tests/stress/']);
  });

  test('ignoredFiles matches a ledger glob against its own on-disk file only', () => {
    const patterns = ['**/a.e2e.ts'];
    expect(ignoredFiles(['a.e2e.ts', 'b.e2e.ts', 'aa.e2e.ts'], patterns)).toEqual(['a.e2e.ts']);
    expect(ignoredFiles(['b.e2e.ts'], patterns)).toEqual([]);
    expect(ignoredFiles(['a.e2e.ts'], [])).toEqual([]);
  });
});
