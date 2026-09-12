import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { APP_PACKAGE_ROOT, computeSeedKey, seedKeyInputs } from '../stress/_helpers/seed-key.ts';
import { withTempDir } from '../temp-dir.test-helper.ts';

const TEMP_DIR_PREFIX = 'ok-warm-cache-seed-key-';
const WORKSPACE_ROOT_FILE_NAMES = ['pnpm-lock.yaml'];
const APP_PACKAGE_FILE_NAMES = [
  'vite.config.ts',
  'vite.dedupe.ts',
  'vite.react-babel.ts',
  'package.json',
];

const HASHED_FILES = [
  ...WORKSPACE_ROOT_FILE_NAMES.map((name) => ({ name, inAppPackage: false })),
  ...APP_PACKAGE_FILE_NAMES.map((name) => ({ name, inAppPackage: true })),
];

function buildWorkspaceFixture(workspaceRoot: string): string {
  const appPackageRoot = join(workspaceRoot, 'packages', 'app');
  mkdirSync(appPackageRoot, { recursive: true });
  for (const name of APP_PACKAGE_FILE_NAMES) {
    writeFileSync(join(appPackageRoot, name), `fixture stand-in for ${name}\n`, 'utf-8');
  }
  for (const name of WORKSPACE_ROOT_FILE_NAMES) {
    writeFileSync(join(workspaceRoot, name), `fixture stand-in for ${name}\n`, 'utf-8');
  }
  return appPackageRoot;
}

describe('warm-cache seed key', () => {
  test('every hashed input resolves in this checkout', () => {
    expect(
      seedKeyInputs(APP_PACKAGE_ROOT).filter((file) => !existsSync(file)),
      "computeSeedKey substitutes the constant 'absent' for a missing input, so a hashed path that no longer resolves freezes that leg and the warm Vite seed stops responding to it",
    ).toEqual([]);
  });

  test('every hashed input has a sensitivity row', () => {
    const workspaceRoot = join(APP_PACKAGE_ROOT, '..', '..');
    const rowTargets = HASHED_FILES.map(({ name, inAppPackage }) =>
      join(inAppPackage ? APP_PACKAGE_ROOT : workspaceRoot, name),
    );

    expect(
      seedKeyInputs(APP_PACKAGE_ROOT).toSorted(),
      'a leg added to seedKeyInputs without a HASHED_FILES row is never checked for actually moving the key',
    ).toEqual(rowTargets.toSorted());
  });

  test('a hashed input that does not resolve warns and still returns a key', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (workspaceRoot) => {
      const appPackageRoot = buildWorkspaceFixture(workspaceRoot);
      const deadLeg = join(appPackageRoot, 'vite.config.ts');
      rmSync(deadLeg);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      onTestFinished(() => warn.mockRestore());

      const key = computeSeedKey(appPackageRoot);

      expect(
        warn,
        'a warn on every leg is indistinguishable from the dead-leg warn it exists to be, which degrades the only out-of-tier signal to per-run noise',
      ).toHaveBeenCalledTimes(1);
      expect(
        String(warn.mock.calls[0]?.[0]),
        'a dead leg must name itself: tiers that never run this file have the warn as their only signal',
      ).toContain(deadLeg);
      expect(
        key,
        'computeSeedKey stays fail-open on a dead leg because it is called outside the warm-cache retry, so throwing would fail globalSetup outright',
      ).toHaveLength(64);
    });
  });

  test.each(HASHED_FILES)('rewriting $name moves the key', async ({ name, inAppPackage }) => {
    await withTempDir(TEMP_DIR_PREFIX, async (workspaceRoot) => {
      const appPackageRoot = buildWorkspaceFixture(workspaceRoot);
      const target = join(inAppPackage ? appPackageRoot : workspaceRoot, name);
      const beforeRewrite = computeSeedKey(appPackageRoot);

      writeFileSync(target, `rewritten ${name}\n`, 'utf-8');

      expect(
        computeSeedKey(appPackageRoot),
        `the seed key must respond to ${name}: an unchanged key means that leg is not hashed, so a persistent checkout reuses a warm Vite seed built against the old inputs`,
      ).not.toBe(beforeRewrite);
    });
  });

  test('an unchanged workspace yields the same key on every call', async () => {
    await withTempDir(TEMP_DIR_PREFIX, async (workspaceRoot) => {
      const appPackageRoot = buildWorkspaceFixture(workspaceRoot);

      expect(
        computeSeedKey(appPackageRoot),
        'the seed key must be deterministic for an unchanged workspace, so a matching seed is reused instead of rebuilt on every run',
      ).toBe(computeSeedKey(appPackageRoot));
    });
  });
});
