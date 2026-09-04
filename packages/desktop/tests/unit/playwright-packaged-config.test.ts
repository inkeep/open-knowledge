import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import packagedConfig, {
  PACKAGED_JSON_REPORT_PATH,
  PACKAGED_SMOKE_SUBSET,
} from '../../playwright.packaged.config';

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const unpackagedSource = readFileSync(join(DESKTOP_ROOT, 'playwright.config.ts'), 'utf8');

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
    expect(unpackagedSource).toContain('stale-build-guard');
  });

  it('writes its JSON report to a path the unpackaged tier does not use', () => {
    expect(PACKAGED_JSON_REPORT_PATH).not.toBe('test-results/desktop-smoke-results.json');
    expect(unpackagedSource).not.toContain(PACKAGED_JSON_REPORT_PATH);
    const json = (packagedConfig.reporter as [string, Record<string, unknown>][]).find(
      ([name]) => name === 'json',
    );
    expect(json?.[1]?.outputFile).toBe(PACKAGED_JSON_REPORT_PATH);
  });

  it('writes its per-test artifacts to a tree the unpackaged tier does not share', () => {
    expect(packagedConfig.outputDir).toBe('test-results-packaged');
    expect(unpackagedSource).not.toContain('test-results-packaged');
  });

  it('leaves the required desktop-smoke check untouched', () => {
    expect(unpackagedSource).not.toMatch(/^\s*projects:/m);
    expect(packagedConfig.projects).toBeUndefined();
  });
});
