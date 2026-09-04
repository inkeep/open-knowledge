import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { E2E_CI_EXCLUSIONS } from '../stress/e2e-ci-ledger';

const APP_ROOT = join(import.meta.dirname, '..', '..');
const STRESS_DIR = join(APP_ROOT, 'tests', 'stress');
const PKG_JSON_PATH = join(APP_ROOT, 'package.json');
const LEDGER_HINT =
  'add the file to the test:e2e script in packages/app/package.json (runs in CI) ' +
  'OR add a ledger entry with reason + evidence in packages/app/tests/stress/e2e-ci-ledger.ts';

function listStressE2eFiles(): string[] {
  return readdirSync(STRESS_DIR)
    .filter((name) => name.endsWith('.e2e.ts'))
    .sort();
}

function nestedE2ePaths(relPaths: readonly string[]): string[] {
  return relPaths
    .filter((p) => p.endsWith('.e2e.ts') && /[/\\]/.test(p))
    .map((p) => p.replace(/\\/g, '/'))
    .sort();
}

function parseEnumeratedFiles(script: string): string[] {
  return script
    .split(/\s+/)
    .filter((token) => token.startsWith('tests/stress/') && token.endsWith('.e2e.ts'))
    .map((token) => token.slice('tests/stress/'.length));
}

interface MembershipViolations {
  unlisted: string[];
  dual: string[];
  staleLedger: string[];
  staleEnumeration: string[];
}

function computeMembershipViolations(
  onDisk: readonly string[],
  enumerated: readonly string[],
  ledgered: readonly string[],
): MembershipViolations {
  const diskSet = new Set(onDisk);
  const enumSet = new Set(enumerated);
  const ledgerSet = new Set(ledgered);
  return {
    unlisted: onDisk.filter((f) => !enumSet.has(f) && !ledgerSet.has(f)),
    dual: onDisk.filter((f) => enumSet.has(f) && ledgerSet.has(f)),
    staleLedger: ledgered.filter((f) => !diskSet.has(f)),
    staleEnumeration: enumerated.filter((f) => !diskSet.has(f)),
  };
}

function loadRealSets(): { onDisk: string[]; enumerated: string[]; ledgered: string[] } {
  const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.['test:e2e'] ?? '';
  return {
    onDisk: listStressE2eFiles(),
    enumerated: parseEnumeratedFiles(script),
    ledgered: E2E_CI_EXCLUSIONS.map((entry) => entry.file),
  };
}

describe('test:e2e membership meta-guard', () => {
  test('the guard has inputs (sanity: stress files exist, enumeration parses)', () => {
    const { onDisk, enumerated } = loadRealSets();
    expect(onDisk.length).toBeGreaterThan(0);
    expect(enumerated.length).toBeGreaterThan(0);
    const nested = nestedE2ePaths(readdirSync(STRESS_DIR, { recursive: true }));
    expect(nested).toEqual([]);
  });

  test('every tests/stress/*.e2e.ts is in the test:e2e enumeration or the exclusion ledger', () => {
    const { onDisk, enumerated, ledgered } = loadRealSets();
    const { unlisted } = computeMembershipViolations(onDisk, enumerated, ledgered);
    if (unlisted.length > 0) {
      throw new Error(
        `CI-invisible stress e2e file(s) — ${LEDGER_HINT}:\n${unlisted
          .map((f) => `  tests/stress/${f}`)
          .join('\n')}`,
      );
    }
  });

  test('no file is in BOTH the test:e2e enumeration and the exclusion ledger', () => {
    const { onDisk, enumerated, ledgered } = loadRealSets();
    const { dual } = computeMembershipViolations(onDisk, enumerated, ledgered);
    if (dual.length > 0) {
      throw new Error(
        `File(s) present in both the test:e2e enumeration and the ledger — a promoted file must have its ledger entry deleted:\n${dual
          .map((f) => `  tests/stress/${f}`)
          .join('\n')}`,
      );
    }
  });

  test('every ledger entry points at a file that still exists', () => {
    const { onDisk, enumerated, ledgered } = loadRealSets();
    const { staleLedger } = computeMembershipViolations(onDisk, enumerated, ledgered);
    if (staleLedger.length > 0) {
      throw new Error(
        `Stale ledger entr(ies) — the file no longer exists; delete the entry from e2e-ci-ledger.ts:\n${staleLedger
          .map((f) => `  ${f}`)
          .join('\n')}`,
      );
    }
  });

  test('every enumerated test:e2e file still exists', () => {
    const { onDisk, enumerated, ledgered } = loadRealSets();
    const { staleEnumeration } = computeMembershipViolations(onDisk, enumerated, ledgered);
    if (staleEnumeration.length > 0) {
      throw new Error(
        `Stale test:e2e entr(ies) — the file no longer exists on disk. Playwright file args are filters, so a stale entry silently matches nothing; remove it from the script:\n${staleEnumeration
          .map((f) => `  tests/stress/${f}`)
          .join('\n')}`,
      );
    }
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
    if (problems.length > 0) {
      throw new Error(`Ledger hygiene violation(s):\n${problems.join('\n')}`);
    }
  });

  test('membership predicate fires on planted violations and not on adjacent negatives', () => {
    const clean = computeMembershipViolations(
      ['a.e2e.ts', 'b.e2e.ts', 'c.e2e.ts'],
      ['a.e2e.ts', 'b.e2e.ts'],
      ['c.e2e.ts'],
    );
    expect(clean.unlisted).toEqual([]);
    expect(clean.dual).toEqual([]);
    expect(clean.staleLedger).toEqual([]);
    expect(clean.staleEnumeration).toEqual([]);

    const unlisted = computeMembershipViolations(['a.e2e.ts', 'd.e2e.ts'], ['a.e2e.ts'], []);
    expect(unlisted.unlisted).toEqual(['d.e2e.ts']);

    const dual = computeMembershipViolations(['a.e2e.ts'], ['a.e2e.ts'], ['a.e2e.ts']);
    expect(dual.dual).toEqual(['a.e2e.ts']);
    expect(dual.unlisted).toEqual([]);

    const staleLedger = computeMembershipViolations(['a.e2e.ts'], ['a.e2e.ts'], ['gone.e2e.ts']);
    expect(staleLedger.staleLedger).toEqual(['gone.e2e.ts']);

    const staleEnum = computeMembershipViolations(['a.e2e.ts'], ['a.e2e.ts', 'gone.e2e.ts'], []);
    expect(staleEnum.staleEnumeration).toEqual(['gone.e2e.ts']);
  });

  test('parseEnumeratedFiles reads only tests/stress e2e tokens from the script', () => {
    const parsed = parseEnumeratedFiles(
      'playwright test tests/stress/a.e2e.ts tests/visual/v.e2e.ts tests/stress/b.e2e.ts --grep foo',
    );
    expect(parsed).toEqual(['a.e2e.ts', 'b.e2e.ts']);
  });

  test('nestedE2ePaths flags subdirectory e2e files and ignores top-level + non-e2e', () => {
    expect(
      nestedE2ePaths(['a.e2e.ts', '_helpers/b.e2e.ts', 'fixtures/data.json', 'c.e2e.ts']),
    ).toEqual(['_helpers/b.e2e.ts']);
    expect(nestedE2ePaths(['_fixtures\\d.e2e.ts'])).toEqual(['_fixtures/d.e2e.ts']);
    expect(nestedE2ePaths(['a.e2e.ts', 'b.e2e.ts'])).toEqual([]);
  });
});
