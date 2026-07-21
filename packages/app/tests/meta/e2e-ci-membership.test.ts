/**
 * `test:e2e` membership meta-guard.
 *
 * CI's Playwright tier runs the explicit file enumeration in packages/app
 * package.json `test:e2e` — Playwright treats CLI file args as filters, so a
 * stress e2e file missing from that list (or a listed file that was later
 * renamed/deleted) is silently invisible: no failure, no skip, no signal.
 * Before this guard, 32 of 83 `tests/stress/*.e2e.ts` files had drifted into
 * that invisible set, including one deterministically failing test.
 *
 * Every `tests/stress/*.e2e.ts` file must therefore be in EXACTLY ONE of:
 *   1. the `test:e2e` enumeration (runs in CI), or
 *   2. the exclusion ledger (`tests/stress/e2e-ci-ledger.ts`) with a reviewed
 *      reason + local-run evidence.
 *
 * The guard also fails on staleness in either direction: a ledger entry whose
 * file no longer exists, or an enumerated file that no longer exists (a
 * deleted file left in the script matches nothing and shrinks CI coverage
 * without any red).
 *
 * The membership predicate is extracted pure and exercised against planted
 * fixtures below — an absence-checker without a planted positive is a vacuous
 * green waiting to happen (same pattern as e2e-stop-rules.test.ts).
 */

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

/** Bare filenames of every on-disk stress e2e file. */
function listStressE2eFiles(): string[] {
  return readdirSync(STRESS_DIR)
    .filter((name) => name.endsWith('.e2e.ts'))
    .sort();
}

/**
 * Relative paths of `.e2e.ts` files that sit in a tests/stress SUBDIRECTORY.
 * Playwright discovers its testDir recursively, so such a file runs under
 * `playwright test` — yet the membership predicate keys on top-level bare
 * filenames, so a nested file falls outside the guard entirely: CI-invisible AND
 * unguarded, the exact class this guard exists to catch. Pure over its input (a
 * recursive readdir) so the sanity check can plant fixtures. The guard is bounded
 * to top-level files by convention — e2e files live at the top of tests/stress/,
 * subdirs hold helpers + fixtures — so a hit means either flatten the file or
 * extend the guard + ledger to carry subpaths.
 */
function nestedE2ePaths(relPaths: readonly string[]): string[] {
  return relPaths
    .filter((p) => p.endsWith('.e2e.ts') && /[/\\]/.test(p))
    .map((p) => p.replace(/\\/g, '/'))
    .sort();
}

/**
 * Bare filenames enumerated by the `test:e2e` script. Only `tests/stress/`
 * tokens are governed here — other suites (visual, a11y) run under their own
 * configs and are out of scope.
 */
function parseEnumeratedFiles(script: string): string[] {
  return script
    .split(/\s+/)
    .filter((token) => token.startsWith('tests/stress/') && token.endsWith('.e2e.ts'))
    .map((token) => token.slice('tests/stress/'.length));
}

interface MembershipViolations {
  /** On disk, but in neither the enumeration nor the ledger — CI-invisible. */
  unlisted: string[];
  /** In BOTH the enumeration and the ledger — contradictory state. */
  dual: string[];
  /** Ledger entries whose file no longer exists on disk. */
  staleLedger: string[];
  /** Enumerated files that no longer exist on disk. */
  staleEnumeration: string[];
}

/**
 * Pure membership predicate over the three sets, so the planted-fixture
 * self-test below can exercise every violation class without touching the
 * real package.json or ledger.
 */
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
    // An empty parse means the test:e2e script shape changed (e.g. moved to a
    // directory/glob invocation). If the whole stress dir now runs in CI,
    // retire this guard and the ledger together; otherwise fix the parser.
    expect(enumerated.length).toBeGreaterThan(0);
    // A nested *.e2e.ts runs under Playwright's recursive testDir scan yet
    // escapes the flat top-level membership sets — fail loud if one appears.
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
    // Clean state: disk fully partitioned across the two lists → no violations.
    const clean = computeMembershipViolations(
      ['a.e2e.ts', 'b.e2e.ts', 'c.e2e.ts'],
      ['a.e2e.ts', 'b.e2e.ts'],
      ['c.e2e.ts'],
    );
    expect(clean.unlisted).toEqual([]);
    expect(clean.dual).toEqual([]);
    expect(clean.staleLedger).toEqual([]);
    expect(clean.staleEnumeration).toEqual([]);

    // Planted: d.e2e.ts on disk but in neither list → CI-invisible.
    const unlisted = computeMembershipViolations(['a.e2e.ts', 'd.e2e.ts'], ['a.e2e.ts'], []);
    expect(unlisted.unlisted).toEqual(['d.e2e.ts']);

    // Planted: a.e2e.ts in both lists → contradictory.
    const dual = computeMembershipViolations(['a.e2e.ts'], ['a.e2e.ts'], ['a.e2e.ts']);
    expect(dual.dual).toEqual(['a.e2e.ts']);
    expect(dual.unlisted).toEqual([]);

    // Planted: ledger references a deleted file → stale ledger.
    const staleLedger = computeMembershipViolations(['a.e2e.ts'], ['a.e2e.ts'], ['gone.e2e.ts']);
    expect(staleLedger.staleLedger).toEqual(['gone.e2e.ts']);

    // Planted: enumeration references a deleted file → stale enumeration.
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
    // Windows-style separators normalize to '/'.
    expect(nestedE2ePaths(['_fixtures\\d.e2e.ts'])).toEqual(['_fixtures/d.e2e.ts']);
    // Purely top-level input has no nested offenders.
    expect(nestedE2ePaths(['a.e2e.ts', 'b.e2e.ts'])).toEqual([]);
  });
});
