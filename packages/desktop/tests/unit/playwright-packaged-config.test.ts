import { isAbsolute, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packagedConfig, {
  PACKAGED_JSON_REPORT_PATH,
  PACKAGED_SMOKE_SUBSET,
} from '../../playwright.packaged.config';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const DESKTOP_ROOT = resolve(import.meta.dirname, '../..');
const UNPACKAGED_JSON_REPORT = resolve(DESKTOP_ROOT, 'test-results/desktop-smoke-results.json');
const PACKAGED_REPORT = resolve(DESKTOP_ROOT, PACKAGED_JSON_REPORT_PATH);
const CONFIG_STATES = (['darwin', 'win32', 'linux'] as const).flatMap((platform) =>
  [false, true].map((ci) => ({ platform, ci })),
);

function outputTree(outputDir: string | undefined): string {
  return resolve(DESKTOP_ROOT, outputDir ?? 'test-results');
}

function containsPath(outer: string, inner: string): boolean {
  const path = relative(outer, inner);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function configStrings(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((item) => configStrings(item, seen));
}

function jsonReportPaths(reporter: unknown): string[] {
  if (!Array.isArray(reporter)) return [];
  return reporter.flatMap((entry) =>
    Array.isArray(entry) && entry[0] === 'json' && typeof entry[1]?.outputFile === 'string'
      ? [resolve(DESKTOP_ROOT, entry[1].outputFile)]
      : [],
  );
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('playwright.packaged.config', () => {
  it('selects exactly the FR5a subset', () => {
    expect([...PACKAGED_SMOKE_SUBSET]).toEqual([
      'cold-single-file-launch.e2e.ts',
      'consent-dialog.e2e.ts',
      'create-new-project.e2e.ts',
      'mcp-wiring.e2e.ts',
    ]);
    expect(packagedConfig.testMatch).toEqual([
      '**/cold-single-file-launch.e2e.ts',
      '**/consent-dialog.e2e.ts',
      '**/create-new-project.e2e.ts',
      '**/mcp-wiring.e2e.ts',
    ]);
  });

  it('runs the same test directory as the unpackaged tier', () => {
    expect(packagedConfig.testDir).toBe('./tests/smoke');
  });

  it('omits the stale-build guard, which cannot describe a packaged bundle', () => {
    expect(packagedConfig.globalSetup).toBeUndefined();
  });

  it('writes its JSON report to a path the unpackaged tier does not use', () => {
    expect(PACKAGED_JSON_REPORT_PATH).not.toBe('test-results/desktop-smoke-results.json');
    const json = (packagedConfig.reporter as [string, Record<string, unknown>][]).find(
      ([name]) => name === 'json',
    );
    expect(json?.[1]?.outputFile).toBe(PACKAGED_JSON_REPORT_PATH);
  });

  it('writes its per-test artifacts to a tree the unpackaged tier does not share', () => {
    expect(packagedConfig.outputDir).toBe('test-results-packaged');
  });

  it('leaves the required desktop-smoke check untouched', () => {
    expect(packagedConfig.projects).toBeUndefined();
  });
});

describe('unpackaged Playwright config in every platform and CI state', () => {
  it.each(CONFIG_STATES)(
    'keeps setup and output isolation on $platform with CI $ci',
    async ({ platform, ci }) => {
      Object.defineProperty(process, 'platform', { value: platform });
      vi.stubEnv('CI', ci ? 'true' : '');
      vi.resetModules();
      const { default: unpackagedConfig } = await import('../../playwright.config');
      const packagedTree = outputTree(packagedConfig.outputDir);
      expect(resolve(DESKTOP_ROOT, String(unpackagedConfig.globalSetup))).toBe(
        resolve(DESKTOP_ROOT, 'tests/smoke/_helpers/stale-build-guard.ts'),
      );
      expect(jsonReportPaths(unpackagedConfig.reporter)).toContain(UNPACKAGED_JSON_REPORT);
      for (const value of configStrings(unpackagedConfig)) {
        const path = resolve(DESKTOP_ROOT, value);
        expect(path, `the unpackaged config value ${value} targets the packaged report`).not.toBe(
          PACKAGED_REPORT,
        );
        expect(
          containsPath(packagedTree, path),
          `the unpackaged config value ${value} resolves into ${packagedTree}`,
        ).toBe(false);
      }
      const unpackagedTree = outputTree(unpackagedConfig.outputDir);
      expect(
        containsPath(unpackagedTree, packagedTree) || containsPath(packagedTree, unpackagedTree),
        `the unpackaged tree ${unpackagedTree} and the packaged tree ${packagedTree} must not nest`,
      ).toBe(false);
      expect(unpackagedConfig.projects).toBeUndefined();
    },
  );
});
